FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
ENV NODE_ENV=production
# Cloud Run listens on $PORT (defaults to 8080 in our code)
CMD ["node", "index.js"]
