ARG SERVER_IMAGE=docker.io/strangev/remote-webview-server:latest
FROM ${SERVER_IMAGE}

USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends jq socat ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY run.sh /run.sh
RUN chmod +x /run.sh

EXPOSE 8081 18080 9221

CMD ["/run.sh"]
