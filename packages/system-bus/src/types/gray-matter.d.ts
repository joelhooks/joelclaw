declare module "gray-matter" {
  export type GrayMatterFile<T extends object = Record<string, unknown>> = {
    data: T;
    content: string;
    excerpt?: string;
  };

  export default function matter<T extends object = Record<string, unknown>>(
    input: string
  ): GrayMatterFile<T>;
}
