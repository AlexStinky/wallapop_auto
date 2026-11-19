"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.imageExtension = imageExtension;
exports.resolveUploadedPhoto = resolveUploadedPhoto;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const extensions = new Map([
    ['image/jpeg', '.jpg'], ['image/png', '.png'], ['image/webp', '.webp'],
    ['image/gif', '.gif'], ['image/avif', '.avif'], ['image/heic', '.heic'],
    ['image/heif', '.heif'], ['image/bmp', '.bmp'], ['image/tiff', '.tiff'],
]);
function imageExtension(mime) {
    return extensions.get(mime.toLowerCase());
}
function resolveUploadedPhoto(reference) {
    // Older records contain full paths. Only their filename refers to an upload.
    const name = path.win32.basename(reference);
    if (!name || /[:\x00-\x1f]/.test(name) || !/\.(?:jpe?g|jfif|png|webp|gif|avif|heic|heif|bmp|tiff?)$/i.test(name))
        return null;
    const file = path.resolve(process.env.UPLOAD_DIR || './uploads', name);
    return fs.lstatSync(file, { throwIfNoEntry: false })?.isFile() ? file : null;
}
