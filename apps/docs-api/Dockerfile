FROM oven/bun:1.3 AS runner

WORKDIR /app

COPY package.json ./
RUN bun install --production

COPY src ./src

EXPOSE 3838

CMD ["bun", "run", "src/index.ts"]
