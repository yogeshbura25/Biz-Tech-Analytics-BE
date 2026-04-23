# Use Node.js 18 LTS alpine for a small footprint
FROM node:18-alpine

# Create app directory
WORKDIR /usr/src/app

# Install app dependencies
# A wildcard is used to ensure both package.json AND package-lock.json are copied
COPY package*.json ./

RUN npm install --production

# Bundle app source
COPY . .

# The app binds to 8081 by default (from .env/index.js)
EXPOSE 8081

# Start the application
CMD [ "node", "index.js" ]
