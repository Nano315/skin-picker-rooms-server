export const mockSocket = {
  id: 'test-socket-id',
  join: jest.fn(),
  leave: jest.fn(),
  emit: jest.fn(),
  on: jest.fn(),
  to: jest.fn().mockReturnThis(),
};

export const mockIo = {
  on: jest.fn((event, callback) => {
    if (event === 'connection') {
      callback(mockSocket);
    }
  }),
  to: jest.fn().mockReturnThis(),
  emit: jest.fn(),
};

const io = jest.fn(() => mockIo);

export default io;
