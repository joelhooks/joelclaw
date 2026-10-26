# ratstack: public talking points

Everything here comes from ratstack.sh (the home page and ratstack.sh/llms.txt,
read 2026-10-26). It is the whole topic for a guest call. Nothing else about
ratstack is known on the call; anything beyond this is "Joel can follow up".

- **What it is:** a way to build an app and its cloud infrastructure as one
  TypeScript program, so TypeScript checks how the parts fit together.
  Joel's goal is the best Effect plus Alchemy application he can build.
- **Effect:** a TypeScript library for dependencies, errors and concurrent
  work. It describes the work with typed failures and named services. A service
  is a named interface for one job.
- **Alchemy:** declares the cloud resources in TypeScript, infers how they
  connect from the code, and plans changes before applying them.
- **The fence:** compiler checks, lint rules and commit hooks that reject
  prohibited code and shortcuts. It makes the easy path the right one, which
  keeps AI coding agents honest.
- **How you use it:** copy rat-stack into your own project and keep its source
  under your control; keep the packages you need and remove the rest with the
  checklists. Or point your coding agent at ratstack.sh/llms.txt and tell it to
  use rat-stack as the reference for how you build.
- **For agents:** the site has docs, a glossary, a search, and an MCP server
  (Model Context Protocol) at ratstack.sh/mcp that Claude Code, Codex or Cursor
  can plug into.
- **It runs on Cloudflare.** The site also has CAFE: reviewed news and a
  directory of projects built on Cloudflare, Alchemy, Foldkit and Effect.
- **Joel's own words on the site:** a lot of it is generated and some reads
  weird; he's rewriting it as he goes. Feedback is welcome at @joelhooks on X.
- **Free workshop:** "Build Agent Loops That Never Stop Shipping", linked from
  the home page.
