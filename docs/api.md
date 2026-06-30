### Request Body Size Limit

All JSON and URL-encoded requests are limited to **10mb** by default.  
Requests exceeding this limit will return:

**Status:** 413 Payload Too Large

**Response Body:**

```json
{
  "error": "Payload Too Large",
  "message": "Request exceeds the maximum size of 10mb"
}
```
