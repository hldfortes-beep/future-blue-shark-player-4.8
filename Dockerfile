FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force
COPY . .
RUN addgroup -S app && adduser -S app -G app && mkdir -p /app/storage/videos && chown -R app:app /app
USER app
EXPOSE 3000
CMD ["node","api/server.js"]
