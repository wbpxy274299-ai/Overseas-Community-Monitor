/**
 * multer 图片上传配置
 */
const path = require('path');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const { UPLOAD_DIR } = require('../config');

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.png';
    cb(null, uuidv4().replace(/-/g, '').slice(0, 8) + ext);
  }
});

const upload = multer({ storage });

module.exports = { upload };
