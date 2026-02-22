import Link from "next/link";

export default function NotFound() {
  return (
    <div>
      <h1 className="text-2xl font-bold tracking-tight">Not found</h1>
      <p className="mt-3 text-neutral-400">
        This page doesn't exist.{" "}
        <Link href="/" className="underline underline-offset-3 hover:text-white transition-colors">
          Go home
        </Link>
        .
      </p>
    </div>
  );
}
