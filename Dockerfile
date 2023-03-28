FROM node:18-alpine as base

WORKDIR /home/app

COPY . .

RUN npm ci --production

CMD [ "npm", "run", "start"]

