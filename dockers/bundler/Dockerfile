FROM node:16-buster-slim
WORKDIR /app/
COPY dist/bundler.js /app/
COPY bundler.sh /app/
COPY workdir /app/workdir
RUN chmod +rx /app/bundler.sh
EXPOSE 8081
ENTRYPOINT [ "/app/bundler.sh" ]
