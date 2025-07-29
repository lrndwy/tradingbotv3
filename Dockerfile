# Use an official Node.js runtime as a parent image
FROM node:18-alpine

# Set the working directory in the container
WORKDIR /app

# Copy package.json and package-lock.json to the working directory
# This allows us to take advantage of Docker layer caching
# If only the application code changes, npm install won't be re-run
COPY package*.json ./

# Install Node.js dependencies
RUN npm install

# Copy the rest of the application files to the working directory
COPY . .

# Expose port 3000, as it's a common default for Node.js applications
EXPOSE 3000

# Define the command to run the application
# Assuming the main application file is bot.js
CMD ["node", "bot.js"]
