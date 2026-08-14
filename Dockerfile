# EzStat MCP server — stdio transport.
#
# The server boots without EZSTAT_API_KEY so MCP introspection (initialize,
# tools/list) works out of the box; pass the key to actually use the tools:
#
#   docker build -t ezstat-mcp-server .
#   docker run -i --rm -e EZSTAT_API_KEY=your-ezkey ezstat-mcp-server
FROM node:22-slim

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
COPY src ./src

# The `prepare` script compiles TypeScript to dist/ during install.
RUN npm install -g pnpm@11 && pnpm install --frozen-lockfile

CMD ["node", "dist/index.js"]
