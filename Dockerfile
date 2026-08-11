FROM brainicism/bgutil-ytdlp-pot-provider:1.3.1-node AS bgutil-provider

FROM python:3.13-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    YTDLP_POT_PROVIDER_URL=http://127.0.0.1:4416

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg ca-certificates libstdc++6 \
    && rm -rf /var/lib/apt/lists/*

COPY --from=bgutil-provider /usr/local/bin/node /usr/local/bin/node
COPY --from=bgutil-provider /app /opt/bgutil-provider

WORKDIR /app

COPY requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

RUN sh -n ./start.sh \
    && node --version

RUN useradd --create-home --uid 10001 appuser \
    && chown -R appuser:appuser /app
USER appuser

EXPOSE 10000

CMD ["sh", "./start.sh"]
