import type { AutoFixHandler } from "./index";

export const ignore: AutoFixHandler = async () => {
  return {
    fixed: true,
    detail: "transient, ignored",
  };
};
