FROM node:18-alpine

# Install Python, pip and ffmpeg for spotdl
RUN apk add --no-cache python3 py3-pip ffmpeg build-base

# Install spotdl (Python package) globally
RUN pip3 install --no-cache-dir spotdl

WORKDIR /usr/src/app

# Copy package.json first to leverage layer caching
COPY package.json ./

# Install node dependencies
RUN npm install --production

# Copy application files
COPY . .

EXPOSE 7860
ENV PORT=7860

CMD ["node", "app.js"]
