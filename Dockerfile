FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
# tsx (a devDependency) runs the server, so install everything.
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
ENV NODE_ENV=production PORT=8080
EXPOSE 8080
CMD ["npx", "tsx", "src/server.ts"]
