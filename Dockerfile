FROM node:20-alpine

# Tetapkan direktori kerja di dalam kontainer
WORKDIR /usr/src/app

# Salin file package.json dan package-lock.json (jika ada)
# Ini memanfaatkan cache Docker. Langkah 'npm install' hanya akan berjalan
# kembali jika file-file ini berubah.
COPY package*.json ./

# Instal semua dependensi yang dibutuhkan oleh bot
RUN npm install

# Salin semua sisa kode aplikasi ke dalam direktori kerja
COPY . .

# Instruksi ini memberitahu Docker bahwa direktori ini akan digunakan untuk
# menyimpan data yang persisten (database SQLite). Anda harus me-mount
# volume ke path ini saat menjalankan kontainer.
VOLUME /usr/src/app

# Perintah default yang akan dijalankan saat kontainer dimulai
CMD ["node", "bot.js"]
