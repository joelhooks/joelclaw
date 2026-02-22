import { defineApp } from "convex/server";
import betterAuth from "@convex-dev/better-auth/convex.config";

type AppConfig = ReturnType<typeof defineApp>;

const app: AppConfig = defineApp();
app.use(betterAuth);

export default app;
