type Task = {
  id: string;
  content: string;
  labels?: string[];
  description?: string;
};

type TasksResponse = {
  results: Task[];
  next_cursor: string | null;
};

function shouldClose(task: Task): boolean {
  const content = task.content ?? "";
  return (
    content.startsWith("Memory:")
    || content.startsWith("Friction:")
    || content.startsWith("- (2026-")
  );
}

async function fetchAgentTasks(token: string): Promise<Task[]> {
  const tasks: Task[] = [];
  let cursor: string | null = null;

  while (true) {
    const url = new URL("https://api.todoist.com/api/v1/tasks");
    url.searchParams.set("filter", "@agent");
    url.searchParams.set("limit", "200");
    if (cursor) {
      url.searchParams.set("cursor", cursor);
    }

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch @agent tasks: ${response.status} ${await response.text()}`);
    }

    const page = (await response.json()) as TasksResponse;
    if (Array.isArray(page.results)) {
      tasks.push(...page.results);
    }

    if (!page.next_cursor) {
      break;
    }
    cursor = page.next_cursor;
  }

  return tasks;
}

async function closeTask(token: string, taskId: string): Promise<void> {
  const response = await fetch(`https://api.todoist.com/api/v1/tasks/${taskId}/close`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to close task ${taskId}: ${response.status} ${await response.text()}`);
  }
}

async function main(): Promise<void> {
  const token = Bun.spawnSync([
    "secrets",
    "lease",
    "todoist_api_token",
    "--ttl",
    "10m",
  ]).stdout.toString().trim();

  if (!token || token.startsWith("{")) {
    throw new Error(`Failed to lease todoist token via secrets CLI. Output: ${token || "<empty>"}`);
  }

  const allAgentTasks = await fetchAgentTasks(token);
  const toClose = allAgentTasks.filter(shouldClose);
  const toKeep = allAgentTasks.filter((task) => !shouldClose(task));

  const failedClosures: Array<{ id: string; error: string }> = [];

  for (const task of toClose) {
    try {
      await closeTask(token, task.id);
    } catch (error) {
      failedClosures.push({
        id: task.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const closedCount = toClose.length - failedClosures.length;

  console.log(`Fetched @agent tasks: ${allAgentTasks.length}`);
  console.log(`Closed: ${closedCount}`);
  console.log(`Kept: ${toKeep.length}`);
  console.log(`Failed to close: ${failedClosures.length}`);
  console.log("\nKept tasks:");
  for (const task of toKeep) {
    console.log(`- [${task.id}] ${task.content}`);
  }

  if (failedClosures.length > 0) {
    console.log("\nClose failures:");
    for (const failure of failedClosures) {
      console.log(`- [${failure.id}] ${failure.error}`);
    }
  }
}

await main();
