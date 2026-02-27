import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { $ } from "bun";
import { NonRetriableError } from "inngest";
import { inngest } from "../client";
import { pushGatewayEvent } from "./agent-loop/utils";

const NAS_HOST = "joel@three-body";
const NAS_VIDEO_BASE = "/volume1/home/joel/video";
const TMP_BASE = "/tmp/video-ingest";

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 80)
    .replace(/-$/, "");
}

function formatDuration(seconds: number): string {
  const h = String(Math.floor(seconds / 3600)).padStart(2, "0");
  const m = String(Math.floor((seconds % 3600) / 60)).padStart(2, "0");
  const s = String(Math.floor(seconds % 60)).padStart(2, "0");
  return `${h}:${m}:${s}`;
}

/**
 * Video Download — downloads video with yt-dlp and transfers to NAS.
 * Emits pipeline/video.downloaded + pipeline/transcript.process
 * Does NOT transcribe — that's a separate composable step.
 */
export const videoDownload = inngest.createFunction(
  {
    id: "video-download",
    concurrency: { limit: 1 },
    retries: 2,
  },
  [{ event: "pipeline/video.requested" }],
  async ({ event, step }) => {
    // Step 1: Download with yt-dlp
    const download = await step.run("download", async () => {
      const url = event.data.url;
      const maxQuality = event.data.maxQuality ?? "1080";
      const runTmpDir = join(TMP_BASE, crypto.randomUUID());

      // Clean only this run's directory to avoid deleting in-flight downloads.
      await $`rm -rf ${runTmpDir} && mkdir -p ${runTmpDir}`.quiet();

      const ytdlp = Bun.spawn(
        [
          "yt-dlp",
          "-f", `bestvideo[height<=${maxQuality}]+bestaudio/best[height<=${maxQuality}]`,
          "--merge-output-format", "mp4",
          "--write-info-json",
          "--write-thumbnail",
          "--output", `${runTmpDir}/%(title)s/%(title)s.%(ext)s`,
          url,
        ],
        { stdout: "pipe", stderr: "pipe", env: process.env }
      );
      await ytdlp.exited;
      // non-zero exit will surface as missing files below

      // Find the subdirectory yt-dlp created
      const entries = await readdir(runTmpDir, { withFileTypes: true });
      const subdir = entries.find((e) => e.isDirectory());
      if (!subdir) throw new Error("yt-dlp did not create a subdirectory");
      const dir = join(runTmpDir, subdir.name) + "/";

      // Find and parse info.json
      const files = await readdir(dir);
      const infoFile = files.find((f) => f.endsWith(".info.json"));
      if (!infoFile) throw new NonRetriableError("No .info.json found");
      const info = JSON.parse(await Bun.file(join(dir, infoFile)).text());

      const title = info.title as string;
      const slug = slugify(title);
      const channel = (info.channel || info.uploader) as string;
      const uploadDate = info.upload_date as string;
      const duration = info.duration as number;

      // Find the mp4 file for transcript processing
      const mp4File = files.find((f) => f.endsWith(".mp4"));
      if (!mp4File) throw new Error("No .mp4 found after download");

      return {
        tmpDir: runTmpDir,
        dir,
        title,
        slug,
        channel,
        publishedDate: `${uploadDate.slice(0, 4)}-${uploadDate.slice(4, 6)}-${uploadDate.slice(6, 8)}`,
        duration: formatDuration(duration),
        sourceUrl: (info.webpage_url as string) ?? url,
        audioPath: join(dir, mp4File),
      };
    });

    // Step 2: Transfer to NAS
    const nasPath = await step.run("transfer-to-nas", async () => {
      const year = new Date().getFullYear();
      const destDir = `${NAS_VIDEO_BASE}/${year}/${download.slug}`;

      await $`ssh ${NAS_HOST} "mkdir -p ${destDir}"`.quiet();
      await $`scp -r ${download.dir}. ${NAS_HOST}:${destDir}/`.quiet();

      return destDir;
    });

    // Step 3: Log download completion
    await step.run("log-download", async () => {
      await $`slog write --action download --tool video-download --detail "${download.title} from ${download.channel} (${download.duration})" --reason "video download via inngest"`.quiet();
    });

    // Step 4: Emit events — trigger transcript processing
    await step.sendEvent("emit-events", [
      {
        name: "pipeline/video.downloaded",
        data: {
          slug: download.slug,
          title: download.title,
          channel: download.channel,
          duration: download.duration,
          nasPath,
          tmpDir: download.tmpDir,
          sourceUrl: download.sourceUrl,
          publishedDate: download.publishedDate,
        },
      },
      {
        name: "pipeline/transcript.requested",
        data: {
          source: "youtube",
          audioPath: download.audioPath,
          title: download.title,
          slug: download.slug,
          channel: download.channel,
          publishedDate: download.publishedDate,
          duration: download.duration,
          sourceUrl: download.sourceUrl,
          nasPath,
          tmpDir: download.tmpDir,
        },
      },
    ]);

    await step.run("push-gateway-event", async () => {
      try {
        await pushGatewayEvent({
          type: "media.downloaded",
          source: "inngest",
          payload: {
            slug: download.slug,
            title: download.title,
            nasPath,
          },
        });
      } catch {}
    });

    return {
      slug: download.slug,
      title: download.title,
      channel: download.channel,
      nasPath,
      status: "downloaded",
    };
  }
);
