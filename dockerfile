FROM mcr.microsoft.com/playwright:v1.55.0-jammy AS deps
WORKDIR /app
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM deps AS build
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM build AS prod-deps
RUN npm prune --omit=dev

FROM mcr.microsoft.com/playwright:v1.55.0-jammy AS runner
ENV NODE_ENV=production
WORKDIR /app

# USER pwuser

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY self-test ./self-test

EXPOSE 8080 8081 9221
CMD ["node", "dist/index.js"]
