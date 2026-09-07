# Multi-stage build: build the static Vite bundle in a Node image, then
# serve it from a minimal nginx image -- the Node toolchain and all dev
# dependencies never need to exist in the final runtime image.
FROM node:22-alpine AS build

WORKDIR /app
COPY package*.json ./
RUN npm ci

COPY . .

# VITE_API_BASE_URL must be set at BUILD time, not runtime -- Vite
# bakes environment variables into the static bundle at build time,
# unlike a server-rendered app where env vars can be read at request
# time. This is passed as a build ARG so the production compose file
# can supply the real backend URL without hardcoding it into this
# Dockerfile.
ARG VITE_API_BASE_URL
ENV VITE_API_BASE_URL=${VITE_API_BASE_URL}
RUN npm run build

FROM nginx:alpine

COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80