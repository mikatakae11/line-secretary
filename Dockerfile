FROM python:3.11-slim

# Node.js 22 をインストール
RUN apt-get update && apt-get install -y curl && \
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && \
    apt-get install -y nodejs && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Python依存関係
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Node.js依存関係
COPY job-scout/package.json job-scout/package-lock.json ./job-scout/
RUN npm install --prefix ./job-scout

# ソースコード全体
COPY . .

CMD gunicorn app:app --workers 1 --threads 4 --timeout 120 --bind 0.0.0.0:${PORT:-10000}
