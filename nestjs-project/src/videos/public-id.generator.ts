import { customAlphabet } from 'nanoid';
import { PUBLIC_ID_ALPHABET, PUBLIC_ID_LENGTH } from './videos.constants';

export const generatePublicId = customAlphabet(
  PUBLIC_ID_ALPHABET,
  PUBLIC_ID_LENGTH,
);
