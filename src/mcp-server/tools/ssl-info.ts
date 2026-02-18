/**
 * SSL Info Tool
 * Fetches SSL certificate information for a URL
 */

import * as tls from 'node:tls';
import * as https from 'node:https';

export interface SSLCertificate {
  subject: {
    commonName?: string;
    organization?: string;
    organizationalUnit?: string;
    country?: string;
    state?: string;
    locality?: string;
  };
  issuer: {
    commonName?: string;
    organization?: string;
    country?: string;
  };
  validFrom: string;
  validTo: string;
  daysRemaining: number;
  serialNumber?: string;
  fingerprint?: string;
  fingerprint256?: string;
  altNames?: string[];
  protocol?: string;
  cipher?: {
    name: string;
    version: string;
  };
}

export interface SSLInfoResult {
  url: string;
  hostname: string;
  port: number;
  isSecure: boolean;
  certificate?: SSLCertificate;
  tlsVersion?: string;
  error?: string;
}

export interface SSLInfoOptions {
  timeout?: number;
}

export async function sslInfo(
  url: string,
  options: SSLInfoOptions = {}
): Promise<SSLInfoResult> {
  const { timeout = 10000 } = options;

  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname;
    const port = parsed.port ? parseInt(parsed.port, 10) : (parsed.protocol === 'https:' ? 443 : 80);

    // If not HTTPS, return early
    if (parsed.protocol !== 'https:') {
      return {
        url,
        hostname,
        port,
        isSecure: false,
        error: 'Site is not using HTTPS',
      };
    }

    return new Promise((resolve) => {
      const socket = tls.connect(
        {
          host: hostname,
          port,
          servername: hostname, // SNI
          rejectUnauthorized: false, // Allow self-signed for analysis
        },
        () => {
          try {
            const cert = socket.getPeerCertificate(true);
            const cipher = socket.getCipher();
            const protocol = socket.getProtocol();

            if (!cert || Object.keys(cert).length === 0) {
              socket.end();
              resolve({
                url,
                hostname,
                port,
                isSecure: true,
                error: 'Could not retrieve certificate',
              });
              return;
            }

            // Calculate days remaining
            const validTo = new Date(cert.valid_to);
            const now = new Date();
            const daysRemaining = Math.floor((validTo.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));

            // Parse subject alternative names
            const altNames = cert.subjectaltname
              ? cert.subjectaltname.split(', ').map((name: string) => name.replace('DNS:', ''))
              : undefined;

            const certificate: SSLCertificate = {
              subject: {
                commonName: cert.subject?.CN,
                organization: cert.subject?.O,
                organizationalUnit: cert.subject?.OU,
                country: cert.subject?.C,
                state: cert.subject?.ST,
                locality: cert.subject?.L,
              },
              issuer: {
                commonName: cert.issuer?.CN,
                organization: cert.issuer?.O,
                country: cert.issuer?.C,
              },
              validFrom: cert.valid_from,
              validTo: cert.valid_to,
              daysRemaining,
              serialNumber: cert.serialNumber,
              fingerprint: cert.fingerprint,
              fingerprint256: cert.fingerprint256,
              altNames,
              protocol: protocol || undefined,
              cipher: cipher ? {
                name: cipher.name,
                version: cipher.version,
              } : undefined,
            };

            socket.end();
            resolve({
              url,
              hostname,
              port,
              isSecure: true,
              certificate,
              tlsVersion: protocol || undefined,
            });
          } catch (err) {
            socket.end();
            resolve({
              url,
              hostname,
              port,
              isSecure: true,
              error: `Certificate parsing error: ${err instanceof Error ? err.message : 'Unknown'}`,
            });
          }
        }
      );

      socket.on('error', (err) => {
        resolve({
          url,
          hostname,
          port,
          isSecure: false,
          error: `Connection error: ${err.message}`,
        });
      });

      socket.setTimeout(timeout, () => {
        socket.destroy();
        resolve({
          url,
          hostname,
          port,
          isSecure: false,
          error: 'Connection timeout',
        });
      });
    });
  } catch (error) {
    return {
      url,
      hostname: '',
      port: 0,
      isSecure: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

// MCP Tool definition
export const sslInfoTool = {
  name: 'ssl-info',
  description: 'Fetches SSL certificate information for a URL',
  inputSchema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'The URL to check SSL certificate for',
      },
      timeout: {
        type: 'number',
        description: 'Connection timeout in milliseconds (default: 10000)',
      },
    },
    required: ['url'],
  },
};
