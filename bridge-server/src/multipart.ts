export interface ParsedMultipartFile {
  fieldName: string;
  fileName: string;
  mimeType: string;
  data: Buffer;
}

export interface ParsedMultipart {
  fields: Record<string, string>;
  files: ParsedMultipartFile[];
}

/**
 * Parses multipart/form-data request bodies (such as Postman file uploads).
 */
export function parseMultipartFormData(
  bodyBuffer: Buffer,
  contentTypeHeader: string,
): ParsedMultipart {
  const result: ParsedMultipart = {
    fields: {},
    files: [],
  };

  const boundaryMatch = contentTypeHeader.match(/boundary=(?:"([^"]+)"|([^;\s]+))/i);
  if (!boundaryMatch) {
    return result;
  }

  const boundary = boundaryMatch[1] || boundaryMatch[2];
  const boundaryBuffer = Buffer.from(`--${boundary}`);
  const endBoundaryBuffer = Buffer.from(`--${boundary}--`);

  let startIndex = 0;

  while (startIndex < bodyBuffer.length) {
    const boundaryIndex = bodyBuffer.indexOf(boundaryBuffer, startIndex);
    if (boundaryIndex === -1) break;

    const partStart = boundaryIndex + boundaryBuffer.length;
    if (partStart >= bodyBuffer.length) break;

    // Check if it's the end boundary
    if (
      bodyBuffer.subarray(boundaryIndex, boundaryIndex + endBoundaryBuffer.length).equals(endBoundaryBuffer)
    ) {
      break;
    }

    // Skip \r\n after boundary
    let headersStart = partStart;
    if (bodyBuffer[headersStart] === 0x0d && bodyBuffer[headersStart + 1] === 0x0a) {
      headersStart += 2;
    } else if (bodyBuffer[headersStart] === 0x0a) {
      headersStart += 1;
    }

    // Find next boundary to know where this part ends
    const nextBoundaryIndex = bodyBuffer.indexOf(boundaryBuffer, headersStart);
    if (nextBoundaryIndex === -1) break;

    let partEnd = nextBoundaryIndex;
    // Trim trailing \r\n before next boundary
    if (partEnd >= 2 && bodyBuffer[partEnd - 2] === 0x0d && bodyBuffer[partEnd - 1] === 0x0a) {
      partEnd -= 2;
    } else if (partEnd >= 1 && bodyBuffer[partEnd - 1] === 0x0a) {
      partEnd -= 1;
    }

    const partBuffer = bodyBuffer.subarray(headersStart, partEnd);

    // Split headers and body at \r\n\r\n or \n\n
    let headerBodySplit = partBuffer.indexOf('\r\n\r\n');
    let headerDelimiterLength = 4;
    if (headerBodySplit === -1) {
      headerBodySplit = partBuffer.indexOf('\n\n');
      headerDelimiterLength = 2;
    }

    if (headerBodySplit !== -1) {
      const headerStr = partBuffer.subarray(0, headerBodySplit).toString('utf8');
      const body = partBuffer.subarray(headerBodySplit + headerDelimiterLength);

      const headers: Record<string, string> = {};
      for (const line of headerStr.split(/\r?\n/)) {
        const colonIdx = line.indexOf(':');
        if (colonIdx !== -1) {
          const key = line.substring(0, colonIdx).trim().toLowerCase();
          const val = line.substring(colonIdx + 1).trim();
          headers[key] = val;
        }
      }

      const contentDisposition = headers['content-disposition'] || '';
      const nameMatch = contentDisposition.match(/name="([^"]+)"/i);
      const filenameMatch = contentDisposition.match(/filename="([^"]+)"/i);
      const contentType = headers['content-type'] || 'application/octet-stream';

      if (nameMatch) {
        const fieldName = nameMatch[1];
        if (filenameMatch) {
          result.files.push({
            fieldName,
            fileName: filenameMatch[1],
            mimeType: contentType,
            data: body,
          });
        } else {
          result.fields[fieldName] = body.toString('utf8');
        }
      }
    }

    startIndex = nextBoundaryIndex;
  }

  return result;
}
