FROM node:18-alpine

# Install Python, pip and ffmpeg for spotdl
RUN apk add --no-cache python3 py3-pip ffmpeg build-base

# Install spotdl (Python package) globally
RUN python3 -m venv /opt/venv \
	&& /opt/venv/bin/pip install --upgrade pip \
	&& /opt/venv/bin/pip install --no-cache-dir spotdl

# Ensure venv binaries (including the `spotdl` CLI) are on PATH
ENV PATH="/opt/venv/bin:${PATH}"

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
