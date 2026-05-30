# Dockerfile for AvianVisitors web app (PHP-FPM)
FROM php:8.2-fpm

# Install system deps required by GD and common utilities
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        libfreetype6-dev \
        libjpeg62-turbo-dev \
        libpng-dev \
        libwebp-dev \
        libzip-dev \
        unzip \
        git \
        curl \
        ca-certificates \
        python3 \
        python3-pip \
    ; \
    docker-php-ext-configure gd --with-freetype --with-jpeg --with-webp; \
    docker-php-ext-install -j"$(nproc)" gd zip; \
    apt-get clean; rm -rf /var/lib/apt/lists/*;

WORKDIR /var/www/html

# Copy app (in development this is usually a bind mount from the host)
COPY . /var/www/html

# Ensure php-fpm user owns the files
RUN chown -R www-data:www-data /var/www/html \
    && find /var/www/html -type f -exec chmod 644 {} \; \
    && find /var/www/html -type d -exec chmod 755 {} \;

EXPOSE 9000

CMD ["php-fpm"]
