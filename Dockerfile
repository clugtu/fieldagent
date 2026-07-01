FROM python:3.12-slim

WORKDIR /app

# Install deps in a separate layer so they're cached on code-only changes
COPY service/requirements.txt service/requirements.txt
RUN pip install --no-cache-dir -r service/requirements.txt

# Copy service source (tests excluded via .dockerignore)
COPY service/ service/

ENV PYTHONPATH=/app

EXPOSE 8080

CMD ["uvicorn", "service.main:app", "--host", "0.0.0.0", "--port", "8080"]
