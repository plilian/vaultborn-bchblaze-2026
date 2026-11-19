FROM node:24-bookworm-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
RUN mkdir -p /app/var && chown node:node /app/var
USER node
ENV HOST=0.0.0.0 PORT=4173 DOMINION_LOCAL_DEMO=false
EXPOSE 4173
CMD ["npm", "start"]
