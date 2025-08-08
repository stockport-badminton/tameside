# Build Stage
FROM node:18-slim AS build

# Set the working directory inside the container
WORKDIR /usr/src/app

# Install build dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
  fontconfig \
  libfreetype6 \
  libfontconfig1 \
  libxrender1 \
  python3 \
  python3-pip \
  python-is-python3 \
  build-essential \
  && fc-cache -f -v \
  && rm -rf /var/lib/apt/lists/*

# Copy package.json and package-lock.json (if available) to leverage Docker's caching
COPY package*.json ./

# Install dependencies (including native ones)
RUN npm ci --only=production

# Copy the application code
COPY . .

# Run build scripts or prepare assets (optional)
# RUN npm run build

# Production Stage
FROM node:22-slim

# Set the working directory inside the container
WORKDIR /usr/src/app

# Install runtime dependencies (fonts)
RUN apt-get update && apt-get install -y --no-install-recommends \
  fontconfig \
  libfreetype6 \
  libfontconfig1 \
  libxrender1 \
  && fc-cache -f -v \
  && rm -rf /var/lib/apt/lists/*

# Copy the production node_modules and built app from the build stage
COPY --from=build /usr/src/app/node_modules ./node_modules
COPY --from=build /usr/src/app .

# Expose the port the app will run on
EXPOSE 8080

# Define the command to run the app
CMD ["npm", "start"]