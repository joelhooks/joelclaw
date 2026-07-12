import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();
crons.daily("purge call dashboard rows older than seven days", { hourUTC: 9, minuteUTC: 15 }, internal.maintenance.purgeExpired);
export default crons;
