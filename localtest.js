const { handler } = require('./func.js');

// 2. Construct a valid event object
// Based on your handler's logic:
// - event.data.resourceName
// - event.data.additionalDetails.bucketName
// - event.data.additionalDetailss.namespace
const mockEvent = {
  data: {
    resourceName: 'in/test/concur-sample-data.csv',
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
  console.log('Calling the handler with a mock event...');
  await handler(mockEvent);
  console.log('Handler call completed.');
}

// Execute the function that calls your handler
executeHandler();