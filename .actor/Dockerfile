# The base image Apify provides: Node 22 plus the tools an Actor needs.
FROM apify/actor-node:22

# Copy only the package files first so the install step can be cached between builds.
COPY package*.json ./

RUN npm --quiet set progress=false \
    && npm install --omit=dev --omit=optional \
    && echo "Installed NPM packages:" \
    && (npm list --omit=dev --all || true) \
    && echo "Node.js version:" \
    && node --version \
    && echo "NPM version:" \
    && npm --version

# Now copy the rest of the source code.
COPY . ./

# What runs when the Actor starts.
CMD npm start --silent
