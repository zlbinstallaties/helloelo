FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

WORKDIR /app
COPY server.py providers.py store.py ./

RUN mkdir /data && chown nobody:nogroup /data
USER nobody
EXPOSE 8080
CMD ["python", "server.py"]
