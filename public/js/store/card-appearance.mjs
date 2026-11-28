import {localImagePath, repositorySourcePath, storageImagePath} from './image-path.mjs?v=117';
export const CARD_STYLES = Object.freeze({
  classic: "Klasik",
  enhanced: "Gelişmiş",
  satin: "Premium",
  prism: "Elite",
  signature: "Ultimate",
});
export const GALLERY_LIMIT = 20;

export function cardStyle(value) {
  return Object.hasOwn(CARD_STYLES, value) ? value : "classic";
}
export function galleryPath(value) { return repositorySourcePath(value) || localImagePath(value) || storageImagePath(value); }
