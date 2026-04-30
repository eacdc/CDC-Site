/**
 * Dual URL resolution for job / product-master image fields (CDC app-side; mirrors portal priority).
 * Legacy: bare filename → baseUrl + filename. If stored value is already http(s) URL, return as-is.
 */

export const DEFAULT_PRODUCT_IMAGE_BASE_URL = 'https://cdcindas.24mycloud.com/Files/ProductImages/';

function trimStr(value) {
	return String(value ?? '').trim();
}

function isAbsoluteHttpUrl(s) {
	return /^https?:\/\//i.test(trimStr(s));
}

function normalizeBase(baseUrl) {
	const raw = trimStr(baseUrl) || DEFAULT_PRODUCT_IMAGE_BASE_URL;
	return raw.endsWith('/') ? raw : `${raw}/`;
}

function legacyUrl(base, filename) {
	const name = trimStr(filename).replace(/^\/+/, '');
	if (!name) return null;
	return `${normalizeBase(base)}${name}`;
}

/**
 * @param {object} opts
 * @param {string|null|undefined} opts.jobCardProductImg — JobBookingJobCard.Jobcardproductimg
 * @param {string|null|undefined} opts.productImgStringName — ProductMaster.ImgStringName
 * @param {string|null|undefined} opts.baseUrl — optional override; default CDC ProductImages base
 * @returns {string|null}
 */
export function resolveProductImageUrl({ jobCardProductImg, productImgStringName, baseUrl }) {
	const j = trimStr(jobCardProductImg);
	if (j) {
		if (isAbsoluteHttpUrl(j)) return j;
		return legacyUrl(baseUrl, j);
	}
	const p = trimStr(productImgStringName);
	if (!p) return null;
	if (isAbsoluteHttpUrl(p)) return p;
	return legacyUrl(baseUrl, p);
}

/** res.cloudinary.com / *.cloudinary.com delivery URLs from upload API */
export function isLikelyCloudinaryDeliveryUrl(url) {
	const s = trimStr(url);
	if (!s || !isAbsoluteHttpUrl(s)) return false;
	try {
		const host = new URL(s).hostname.toLowerCase();
		return host === 'res.cloudinary.com' || host.endsWith('.cloudinary.com');
	} catch {
		return false;
	}
}

/**
 * Public ID for cloudinary.uploader.destroy (folder/id without extension).
 * Handles .../image/upload/v123/folder/file.jpg
 */
export function cloudinaryPublicIdFromDeliveryUrl(url) {
	const s = trimStr(url);
	if (!isLikelyCloudinaryDeliveryUrl(s)) return null;
	try {
		const path = new URL(s).pathname;
		const marker = '/image/upload/';
		const i = path.indexOf(marker);
		if (i === -1) return null;
		let rest = path.slice(i + marker.length);
		rest = rest.replace(/^v\d+\//, '');
		rest = rest.replace(/\.[^/.]+$/, '');
		return rest || null;
	} catch {
		return null;
	}
}
