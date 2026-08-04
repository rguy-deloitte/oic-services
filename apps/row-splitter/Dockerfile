FROM fnproject/node:22-dev AS build-stage
WORKDIR /function
ADD package.json /function/
RUN npm install
ADD . /function/
RUN npm run build && npm prune --omit=dev && chown -R $(id -u):$(id -g) node_modules

FROM fnproject/node:22
WORKDIR /function
COPY --from=build-stage /function/node_modules/ /function/node_modules/
COPY --from=build-stage /function/dist/ /function/dist/
ENTRYPOINT ["node", "dist/func.js"]
