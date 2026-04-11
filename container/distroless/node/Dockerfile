FROM node:24.14.1-slim AS base
ARG APP_DIR="/app"
WORKDIR $APP_DIR
COPY . .
RUN npm install --omit=dev
RUN npm run build
# ログディレクトリを nonroot所有で作成
RUN mkdir /logs && chown -R nonroot:nonroot /logs

FROM gcr.io/distroless/nodejs24-debian13:nonroot AS app
ARG APP_DIR="/app"
WORKDIR $APP_DIR
COPY --from=base --chown=nonroot:nonroot $APP_DIR .
COPY --from=base --chown=nonroot:nonroot /logs /logs
EXPOSE 3000
CMD ["index.js"]
