export type PrdStoryPlan = {
  id: string;
  title: string;
  summary: string;
  prompt: string;
  files?: string[];
  dependsOn?: string[];
  timeoutSeconds?: number;
  sandbox?: "workspace-write" | "danger-full-access";
};

export type PrdWavePlan = {
  id: string;
  stories: PrdStoryPlan[];
};

export type PrdExecutionPlan = {
  summary: string;
  waves: PrdWavePlan[];
};
