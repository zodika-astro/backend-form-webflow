// modules/birthchart/validators.js

const { z } = require('zod');
const birthchartSchema = z.object({
  name: z.string().min(3, 'name must have at least 3 characters'),
  social_name: z.string().optional(),
  email: z.string().email('invalid email format'),
  birth_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date format must be YYYY-MM-DD'),
  birth_time: z.string().regex(/^\d{2}:\d{2}$/, 'time format must be HH:MM'),
  birth_place: z.string().min(2, 'birth place must have at least 2 characters'),
  product_type: z.string(),
  birth_place_place_id: z.string().optional(),
  birth_place_full: z.string().optional(),
  birth_place_country: z.string().length(2).optional(),
  birth_place_admin1: z.string().optional(),
  birth_place_admin2: z.string().optional(),
  birth_place_lat: z.string().optional(),
  birth_place_lng: z.string().optional(),
  birth_place_json: z.string().optional(),
  birth_timezone_id: z.string().optional(),
  birth_utc_offset_min: z.string().or(z.number()).optional()
});

function validateBirthchartPayload(payload) {
    try {
        birthchartSchema.parse(payload);
    } catch (error) {
        throw new Error(`Validation Error: ${error.message}`);
    }
}
module.exports = {
  validateBirthchartPayload,
};
