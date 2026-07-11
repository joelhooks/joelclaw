import { handle } from "hono/vercel";
import { createApp } from "../src/app.js";

export const config = {
  runtime: "edge",
};

export default handle(createApp());
