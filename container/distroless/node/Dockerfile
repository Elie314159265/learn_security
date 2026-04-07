FROM node:24.14.1-slim AS base
ARG APP_DIR="/app"
WORKDIR $APP_DIR
COPY . .
RUN npm install --omit=dev
RUN npm run build

FROM gcr.io/distroless/nodejs24-debian13:nonroot AS app
ARG APP_DIR="/app"
WORKDIR $APP_DIR
COPY --from=base --chown=nonroot:nonroot $APP_DIR .
EXPOSE 3000
CMD ["index.js"]


