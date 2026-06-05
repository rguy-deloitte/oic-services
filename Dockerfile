FROM fnproject/node:22-dev AS build-stage
WORKDIR /function
ADD package.json /function/
RUN npm install  && chown -R $(id -u):$(id -g) node_modules

FROM fnproject/node:22
WORKDIR /function
ADD . /function/
COPY --from=build-stage /function/node_modules/ /function/node_modules/
ENTRYPOINT ["node", "func.js"]
