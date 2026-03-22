import fs from 'node:fs';
import path from 'node:path';

import express from 'express';
import sanitize from 'sanitize-filename';

import { invalidateThumbnail } from './thumbnails.js';
import { getOrGenerateMetadataBatch, removeMetadata, renameMetadata, thumbnailDimensions } from './image-metadata.js';
import { getImages } from '../util.js';
import { getFileNameValidationFunction } from '../middleware/validateFileName.js';
import { getStorageProvider } from '../storage-provider.js';

export const router = express.Router();

router.post('/all', async function (request, response) {
    try {
        const localImages = getImages(request.user.directories.backgrounds);

        const storageProvider = getStorageProvider();
        if (storageProvider?.listBackgrounds) {
            const handle = request.user.profile.handle;
            const remoteImages = await storageProvider.listBackgrounds(handle);
            // Merge local + remote, deduplicate by filename
            const seen = new Set(localImages);
            for (const img of remoteImages) {
                if (!seen.has(img)) {
                    localImages.push(img);
                    seen.add(img);
                }
            }
        }

        const config = { width: thumbnailDimensions.bg[0], height: thumbnailDimensions.bg[1] };
        response.json({ images: localImages, config });
    } catch (error) {
        console.error('Error listing backgrounds:', error);
        response.status(500).send({ error: 'Failed to list backgrounds' });
    }
});

router.post('/delete', getFileNameValidationFunction('bg'), async function (request, response) {
    if (!request.body) return response.sendStatus(400);

    if (request.body.bg !== sanitize(request.body.bg)) {
        console.error('Malicious bg name prevented');
        return response.sendStatus(403);
    }

    const bgName = sanitize(request.body.bg);

    const storageProvider = getStorageProvider();
    if (storageProvider?.deleteFile) {
        try {
            const handle = request.user.profile.handle;
            await storageProvider.deleteFile(handle, `backgrounds/${bgName}`);
            invalidateThumbnail(request.user.directories, 'bg', bgName);
            return response.send('ok');
        } catch (err) {
            console.error('Error deleting background from storage provider:', err);
            return response.sendStatus(500);
        }
    }

    const fileName = path.join(request.user.directories.backgrounds, bgName);

    if (!fs.existsSync(fileName)) {
        console.error('BG file not found');
        return response.sendStatus(400);
    }

    fs.unlinkSync(fileName);
    invalidateThumbnail(request.user.directories, 'bg', bgName);

    // Remove metadata for deleted image
    const relativePath = path.join('backgrounds', request.body.bg);
    removeMetadata(request.user.directories.root, relativePath).catch(err => {
        console.warn('[Backgrounds] Failed to remove metadata:', err.message);
    });

    return response.send('ok');
});

router.post('/rename', async function (request, response) {
    if (!request.body) return response.sendStatus(400);

    const oldBgName = sanitize(request.body.old_bg);
    const newBgName = sanitize(request.body.new_bg);

    const storageProvider = getStorageProvider();
    if (storageProvider?.renameBackground) {
        try {
            const handle = request.user.profile.handle;
            await storageProvider.renameBackground(handle, oldBgName, newBgName);
            invalidateThumbnail(request.user.directories, 'bg', oldBgName);
            return response.send('ok');
        } catch (err) {
            console.error('Error renaming background in storage provider:', err);
            return response.sendStatus(500);
        }
    }

    const oldFileName = path.join(request.user.directories.backgrounds, oldBgName);
    const newFileName = path.join(request.user.directories.backgrounds, newBgName);

    if (!fs.existsSync(oldFileName)) {
        console.error('BG file not found');
        return response.sendStatus(400);
    }

    if (fs.existsSync(newFileName)) {
        console.error('New BG file already exists');
        return response.sendStatus(400);
    }

    fs.copyFileSync(oldFileName, newFileName);
    fs.unlinkSync(oldFileName);
    invalidateThumbnail(request.user.directories, 'bg', request.body.old_bg);

    // Update metadata for renamed image
    const oldRelativePath = path.join('backgrounds', request.body.old_bg);
    const newRelativePath = path.join('backgrounds', request.body.new_bg);
    renameMetadata(request.user.directories.root, oldRelativePath, newRelativePath).catch(err => {
        console.warn('[Backgrounds] Failed to rename metadata:', err.message);
    });

    return response.send('ok');
});

router.post('/upload', async function (request, response) {
    if (!request.body || !request.file) return response.sendStatus(400);

    const img_path = path.join(request.file.destination, request.file.filename);
    const filename = sanitize(request.file.originalname);

    try {
        const storageProvider = getStorageProvider();
        if (storageProvider?.saveFile) {
            const handle = request.user.profile.handle;
            const buffer = fs.readFileSync(img_path);
            await storageProvider.saveFile(handle, `backgrounds/${filename}`, buffer);
            fs.unlinkSync(img_path);
            invalidateThumbnail(request.user.directories, 'bg', filename);
            return response.send(filename);
        }

        fs.copyFileSync(img_path, path.join(request.user.directories.backgrounds, filename));
        fs.unlinkSync(img_path);
        invalidateThumbnail(request.user.directories, 'bg', filename);

        // Generate metadata for the new image
        const relativePath = path.join('backgrounds', filename);
        getOrGenerateMetadataBatch(request.user.directories.root, [relativePath], 'bg').catch(err => {
            console.warn('[Backgrounds] Failed to generate metadata for upload:', err.message);
        });

        response.send(filename);
    } catch (err) {
        console.error(err);
        response.sendStatus(500);
    }
});
