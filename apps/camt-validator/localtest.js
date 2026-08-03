const { handler } = require('./func.js');

// Construct a valid event object
// Based on your handler's logic:
// - event.data.resourceName
// - event.data.additionalDetails.bucketName
// - event.data.additionalDetails.namespace
const mockEvent = {
  data: {
    resourceName: 'camt-validator/source/test/example_CAMT.053.001.02.xml',
    additionalDetails: {
      bucketName: 'oci-object-storage',
      namespace: 'localtest'
    }
  },
  // You can add other event properties if your handler might use them,
  // e.g., 'eventType', 'cloudEventsVersion', 'id', 'source', 'time', etc.
  eventType: 'com.example.object.create',
  id: 'some-unique-event-id-456',
  time: new Date().toISOString()
};

// 3. Call the handler function
async function executeHandler() {
  console.log('Calling the camt-validator handler with a mock event...');
  await handler(mockEvent);
  console.log('Handler call completed.');
}

// Execute the function that calls your handler
executeHandler();