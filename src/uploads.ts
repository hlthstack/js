/**
 * A file to upload: a `Blob`/`File`, raw bytes (`ArrayBuffer`, `Uint8Array`, Node `Buffer`),
 * or an object with the bytes plus a filename and content type.
 *
 * The API accepts PDF, JPEG and PNG. Send a filename with a matching extension (or a
 * `contentType`) so the server can recognise the format.
 */
export type FileInput =
  | Blob
  | ArrayBuffer
  | ArrayBufferView
  | {
      data: Blob | ArrayBuffer | ArrayBufferView;
      /** Defaults to the `File` name, else `file`. */
      filename?: string;
      /** Defaults to the Blob's type, else inferred from the filename extension. */
      contentType?: string;
    };

const EXTENSION_TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
};

function isFileObject(value: FileInput): value is Extract<FileInput, { data: unknown }> {
  return typeof value === 'object' && value !== null && 'data' in value && !(value instanceof Blob);
}

function guessType(filename: string): string | undefined {
  const ext = filename.split('.').pop()?.toLowerCase();
  return ext ? EXTENSION_TYPES[ext] : undefined;
}

/** Converts a {@link FileInput} into a Blob and filename for `FormData.append`. */
export function toBlob(input: FileInput): { blob: Blob; filename: string } {
  const { data, filename: explicitName, contentType } = isFileObject(input)
    ? input
    : { data: input, filename: undefined, contentType: undefined };

  const fileName =
    typeof File !== 'undefined' && data instanceof File && data.name ? data.name : undefined;
  const filename = explicitName ?? fileName ?? 'file';

  if (data instanceof Blob) {
    const type = contentType ?? (data.type || guessType(filename));
    if (!type || type === data.type) return { blob: data, filename };
    return { blob: new Blob([data], { type }), filename };
  }

  const bytes: BlobPart =
    data instanceof ArrayBuffer
      ? data
      : new Uint8Array(data.buffer as ArrayBuffer, data.byteOffset, data.byteLength);
  const type = contentType ?? guessType(filename) ?? 'application/octet-stream';
  return { blob: new Blob([bytes], { type }), filename };
}
