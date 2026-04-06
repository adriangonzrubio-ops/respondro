import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

// 1. Establish the fake browser environment FIRST
if (typeof global !== 'undefined') {
  if (!global.DOMMatrix) global.DOMMatrix = class DOMMatrix {} as any;
  if (!global.Path2D) global.Path2D = class Path2D {} as any;
}

export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const file = formData.get('file') as File | null;

    if (!file) {
      return NextResponse.json({ error: 'No file uploaded' }, { status: 400 });
    }

    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    
    let extractedText = '';

    if (file.name.toLowerCase().endsWith('.pdf')) {
      // 2. NOW dynamically load the untouched package safely AFTER the polyfills exist
      const pdfModule = await import('pdf-parse');
      // Safely unwrap it just in case Next.js packaged it weirdly
      const parsePdf = pdfModule.default || pdfModule;
      
      const data = await parsePdf(buffer);
      extractedText = data.text;
    } else {
      extractedText = buffer.toString('utf-8');
    }

    return NextResponse.json({ text: extractedText });
    
  } catch (error: any) {
    console.error('Error parsing document:', error);
    return NextResponse.json({ error: error.message || 'Failed to parse document' }, { status: 500 });
  }
}