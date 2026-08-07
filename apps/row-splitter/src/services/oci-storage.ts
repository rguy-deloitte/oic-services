import { ResourcePrincipalAuthenticationDetailsProvider } from 'oci-common';
import { ObjectStorageClient } from 'oci-objectstorage';

export interface ObjectStorageFile {
    filename: string;
    bucketName: string;
    namespaceName: string;
    contentType: string;
    content: Buffer;
}

interface ArrayBufferBody { arrayBuffer(): Promise<ArrayBuffer> }
interface StreamReaderBody { getReader(): { read(): Promise<{ done: boolean; value: Uint8Array | undefined }> } }

// Reuse a single client across invocations within the same function container.
let objectStorageClientPromise: Promise<ObjectStorageClient> | undefined;

function getObjectStorageClient(): Promise<ObjectStorageClient> {
    if (!objectStorageClientPromise) {
        objectStorageClientPromise = (async () => {
            const authenticationDetailsProvider = await ResourcePrincipalAuthenticationDetailsProvider.builder();
            return new ObjectStorageClient({ authenticationDetailsProvider });
        })();
    }
    return objectStorageClientPromise;
}

function readableToBuffer(readable: NodeJS.ReadableStream): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        readable.on('data', (chunk) => {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        readable.on('error', reject);
        readable.on('end', () => resolve(Buffer.concat(chunks)));
    });
}

// Allow any response body type from Object Storage to be read by other functions by converting it to a Buffer
async function bodyToBuffer(value: unknown): Promise<Buffer> {
    if (!value) return Buffer.alloc(0);
    if (Buffer.isBuffer(value)) return value;
    if (value instanceof Uint8Array) return Buffer.from(value);
    if (typeof (value as Partial<ArrayBufferBody>).arrayBuffer === 'function') {
        return Buffer.from(await (value as ArrayBufferBody).arrayBuffer());
    }
    if (typeof (value as Partial<StreamReaderBody>).getReader === 'function') {
        const reader = (value as StreamReaderBody).getReader();
        const chunks: Buffer[] = [];
        while (true) {
            const { done, value: chunk } = await reader.read();
            if (done) break;
            chunks.push(Buffer.from(chunk!));
        }
        return Buffer.concat(chunks);
    }
    if (typeof (value as Partial<NodeJS.ReadableStream>).on === 'function') {
        return readableToBuffer(value as NodeJS.ReadableStream);
    }
    throw new Error('Unsupported Object Storage response body type');
}

export async function downloadObject(
    filename: string,
    bucketName: string,
    namespaceName: string,
): Promise<ObjectStorageFile> {
    if (!filename) throw new Error('filename is required');
    if (!bucketName || !namespaceName) {
        throw new Error('bucketName and namespaceName are required to load a file from Object Storage');
    }
    const client = await getObjectStorageClient();
    const response = await client.getObject({ namespaceName, bucketName, objectName: filename });
    return {
        filename,
        bucketName,
        namespaceName,
        contentType: response.contentType,
        content: await bodyToBuffer(response.value),
    };
}

export async function uploadObject(
    directory: string,
    filename: string,
    content: Buffer,
    contentType: string,
    bucketName: string,
    namespaceName: string,
): Promise<void> {
    const client = await getObjectStorageClient();
    await client.putObject({
        namespaceName,
        bucketName,
        objectName: `${directory}${filename}`,
        contentType,
        contentLength: content.length,
        putObjectBody: content,
    });
}
