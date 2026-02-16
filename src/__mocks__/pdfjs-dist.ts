// Mock for pdfjs-dist to avoid ESM issues in Jest

export const getDocument = jest.fn().mockReturnValue({
  promise: Promise.resolve({
    numPages: 1,
    getPage: jest.fn().mockResolvedValue({
      getTextContent: jest.fn().mockResolvedValue({
        items: [{ str: 'Mock PDF text content' }],
      }),
      getViewport: jest.fn().mockReturnValue({
        width: 612,
        height: 792,
      }),
    }),
  }),
});

export const GlobalWorkerOptions = {
  workerSrc: '',
};

export default {
  getDocument,
  GlobalWorkerOptions,
};
