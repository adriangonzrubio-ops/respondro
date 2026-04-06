import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

// Trick the server into thinking browser features exist
if (typeof global !== 'undefined') {
  if (!global.DOMMatrix) global.DOMMatrix = class DOMMatrix {} as any;
  if (!global.Path2D) global.Path2D = class Path2D {} as any;
}

export async function POST(request: Request) {
  try {
    // 🛠️ THE FIX: Safely unwrap the imported module whether Vercel minifies it or not
    const pdfLib = require('pdf-parse');
    const parsePdf = pdfLib.default || pdfLib;

    const formData = await request.formData();
    const file = formData.get('file') as File | null;

    if (!file) {
      return NextResponse.json({ error: 'No file uploaded' }, { status: 400 });
    }

    // Convert the uploaded file into a format Node.js can read
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    
    let extractedText = '';

    // Route logic based on file type
    if (file.name.toLowerCase().endsWith('.pdf')) {
      // Use the safely unwrapped function here
      const data = await parsePdf(buffer);
      extractedText = data.text;
    } else {
      // Fallback for standard .txt files
      extractedText = buffer.toString('utf-8');
    }

    // Send the extracted text back to the frontend
    return NextResponse.json({ text: extractedText });
    
  } catch (error: any) {
    console.error('Error parsing document:', error);
    return NextResponse.json({ error: error.message || 'Failed to parse document' }, { status: 500 });
  }
}